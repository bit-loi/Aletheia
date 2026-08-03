/**
 * pipeline.js: Shared fact-checking pipeline powered by the hosted LLM proxy.
 *
 * Three stages:
 *   1. extractClaims(text)     → string[]          : pulls falsifiable claims from text
 *   2. retrieveEvidence(claim) → EvidenceItem[]     : web search for each claim via Tavily
 *   3. generateVerdict(claim, evidence) → Verdict   : grounded True/False/Misleading/Unverified
 *
 * All API calls happen in the service-worker context (no CORS issues).
 */

import { CONFIG } from '../config.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reads legacy personal keys from chrome.storage.sync. New installs use the
 * hosted proxy and do not need to save credentials.
 */
export async function getSettings() {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(
      ['llmKey', 'nvidiaKey', 'tavilyKey'],
      (data) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }

        let llmKey = data.llmKey || '';
        if (!llmKey && data.nvidiaKey) {
          if (data.nvidiaKey.startsWith('nvapi-')) {
            chrome.storage.sync.remove(['nvidiaKey']).catch(() => {});
          } else {
            llmKey = data.nvidiaKey;
          }
        }

        resolve({
          llmKey: llmKey || CONFIG.LLM_API_KEY,
          tavilyKey: data.tavilyKey || CONFIG.TAVILY_API_KEY,
        });
      }
    );
  });
}

/**
 * Safely parse a JSON string that the LLM might have wrapped in markdown fences or conversational text.
 */
function parseJSON(raw) {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Try parsing directly first
  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  // Extract JSON array if present
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch (_) {}
  }

  // Extract JSON object if present
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch (_) {}
  }

  throw new Error(`Invalid JSON format: ${raw.slice(0, 150)}`);
}

/**
 * Call the hosted proxy, which holds provider keys server-side and fails over
 * across a provider chain. This is the default path: it is what lets the
 * extension work on install with nothing configured.
 */
async function callProxy(path, body) {
  const base = (CONFIG.PROXY_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('The Aletheia proxy is not configured.');

  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    throw new Error('Aletheia is busy right now (shared quota). Try again shortly.');
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `Proxy error (${res.status})`);
  }
  return res.json();
}

/** Evidence retrieval through the proxy, for users with no Tavily key. */
async function retrieveEvidenceViaProxy(claim) {
  try {
    const data = await callProxy('/v1/search', { query: claim, max_results: 3 });
    return (data.results || []).map((r) => ({
      title: r.title || 'Untitled',
      url: r.url || '',
      snippet: r.snippet || '',
    }));
  } catch (err) {
    console.warn('[Aletheia] Proxy search failed:', err.message);
    return [];
  }
}

export async function callLLM(promptText, temperature = 0.3, maxTokens = 2048) {
  const { llmKey } = await getSettings();
  const apiKey = llmKey && llmKey.trim() ? llmKey.trim() : CONFIG.LLM_API_KEY;

  // Try direct key if available and not a legacy nvapi key
  if (apiKey && !apiKey.startsWith('nvapi-')) {
    const url = CONFIG.LLM_DIRECT_URL;
    const modelsToTry = [CONFIG.LLM_DIRECT_MODEL];

    for (const model of modelsToTry) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
          body: JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: promptText }],
            temperature: temperature,
            top_p: 0.95,
            max_tokens: maxTokens,
            stream: false,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          const content = data.choices?.[0]?.message?.content;
          if (content && content.trim().length > 0) {
            return content;
          }
        } else {
          console.warn(`[Aletheia] Direct LLM API returned status ${res.status}, falling back to proxy.`);
        }
      } catch (err) {
        console.warn(`[Aletheia] Error with direct model ${model}, falling back to proxy:`, err.message);
      }
    }
  }

  // Fallback to hosted proxy (handles provider failover automatically)
  const data = await callProxy('/v1/chat', {
    messages: [{ role: 'user', content: promptText }],
    temperature,
    max_tokens: maxTokens,
  });
  return data.content;
}

// ─── Stage 1: Claim Extraction ────────────────────────────────────────────────

const CLAIM_EXTRACTION_PROMPTS = {
  id: `Anda adalah asisten pemeriksa fakta profesional. Tugas Anda adalah mengekstrak klaim faktual spesifik yang dapat diverifikasi kebenarannya dari teks berikut.

Aturan:
- Hanya sertakan klaim yang dapat diverifikasi dengan sumber eksternal (statistik, peristiwa, pernyataan tokoh, fakta ilmiah).
- Setiap klaim harus berdiri sendiri dan mudah dipahami tanpa membaca seluruh teks.
- JANGAN menyertakan opini, prediksi, pertanyaan retoris, atau klaim samar.
- Tulis ulang setiap klaim menjadi kalimat yang jelas dan tepat dalam Bahasa Indonesia.
- Batasi hingga 2–4 klaim paling signifikan dan penting.
- Berikan hasil HANYA berupa JSON array of strings dalam Bahasa Indonesia. Tanpa penjelasan tambahan, tanpa markdown format.

Contoh output:
["Pertumbuhan PDB Indonesia mencapai 5,1% pada Q3 2025.", "WHO menyatakan mpox sebagai darurat kesehatan global pada Agustus 2024."]`,

  en: `You are a professional fact-checking assistant. Your task is to extract specific, discrete, falsifiable factual claims from the following text.

Rules:
- Only include claims that can be verified against external sources (statistics, events, attributions, scientific statements).
- Each claim must be self-contained (understandable without the surrounding text).
- Do NOT include opinions, predictions, rhetorical questions, or vague statements.
- Rewrite each claim as a clear, concise sentence in English.
- Limit to the 2 to 4 most significant, distinct, and verifiable claims.
- Return ONLY a valid JSON array of strings in English. No explanation, no markdown format.

Example output:
["Indonesia GDP growth reached 5.1% in Q3 2025.", "WHO declared mpox a global health emergency in August 2024."]`,

  ja: `あなたはプロのファクトチェックアシスタントです。以下のテキストから、検証可能な具体的な事実クライアントを抽出してください。

ルール:
- 外部ソースで検証可能なクライアントのみ含めてください（統計、出来事、発言帰属、科学的声明）。
- 各クライアントは独立して理解可能である必要があります。
- 意見、予測、修辞的な質問、曖昧な声明は含めないでください。
- 各クライアントを明確で簡潔な日本語の文に書き換えてください。
- 最も重要で検証可能な2〜4つのクライアントに限定してください。
- 有効なJSON文字列の配列のみを日本語で返してください。説明やマークダウン形式は不要です。

出力例:
["インドネシアのGDP成長率は2025年第3四半期に5.1%に達した。", "WHOは2024年8月にエムポックスを国際的に懸念される公衆衛生上の緊急事態と宣言した。"]`,

  ko: `당신은 프로 팩트체크 어시스턴트입니다. 다음 텍스트에서 구체적이고 검증 가능한 사실 주장을 추출하세요.

규칙:
- 외부 소스로 검증 가능한 주장만 포함하세요 (통계, 사건, 발언 인용, 과학적 진술).
- 각 주장은 독립적으로 이해할 수 있어야 합니다.
- 의견, 예측, 수사적 질문, 모호한 진술은 포함하지 마세요.
- 각 주장을 명확하고 간결한 한국어 문장으로 다시 작성하세요.
- 가장 중요하고 검증 가능한 2~4개의 주장으로 제한하세요.
- 유효한 JSON 문자열 배열만 한국어로 반환하세요. 설명이나 마크다운 형식은 필요 없습니다.

출력 예:
["인도네시아 GDP 성장률은 2025년 3분기에 5.1%에 도달했습니다.", "WHO는 2024년 8월에 엠폴ックス를 글로벌 보건 비상사태로 선언했습니다."]`,

  zh: `您是专业的事实核查助手。从以下文本中提取具体的、可验证的事实陈述。

规则:
- 仅包含可针对外部来源验证的陈述（统计数据、事件、归因、科学声明）。
- 每个陈述必须独立可理解。
- 不要包含意见、预测、修辞疑问或模糊陈述。
- 将每个陈述改写为清晰简洁的中文句子。
- 限制为2-4个最重要且可验证的陈述。
- 仅返回有效的JSON字符串数组（中文）。无需解释或markdown格式。

输出示例:
["印度尼西亚GDP增长率在2025年第三季度达到5.1%。", "世卫组织于2024年8月宣布猴痘为全球卫生紧急事件。"]`,

  ar: `أنت مساعد فحص حقائق محترف. مهمتك هي استخراج ادعاءات واقعية محددة وقابلة للتحقق من النص التالي.

القواعد:
- قم فقط بادعاءات يمكن التحقق منها مقارنةً بمصادر خارجية (إحصائيات، أحداث، نسب، بيانات علمية).
- يجب أن يكون كل ادعاء مستقلاً وواضحًا.
- لا تشمل الآراء أو التنبؤات أو الأسئلة البلاغية أو الادعامات الغامضة.
- أعد صياغة كل ادعاء كجملة واضحة وموجزة بالعربية.
- اقتصر على 2-4 من الادعاءات الأكثر أهمية وقابلية للتحقق.
- أعد فقط مصفوفة JSON صالحة بالعربية. لا شرح ولا تنسيق markdown.

مثال على المخرجات:
["بلغ نمو الناتج المحلي الإجمالي لإندونيسيا 5.1% في الربع الثالث من 2025.", "أعلنت منظمة الصحة العالمية أن الموزونوبوكس حالة طوارئ صحية عالمية في أغسطس 2024."]`,

  es: `Eres un asistente profesional de verificación de hechos. Tu tarea es extraer afirmaciones factuales específicas y verificables del siguiente texto.

Reglas:
- Solo incluye afirmaciones que puedan verificarse contra fuentes externas (estadísticas, eventos, atribuciones, declaraciones científicas).
- Cada afirmación debe ser independiente (comprensible sin el texto circundante).
- NO incluyas opiniones, predicciones, preguntas retóricas o declaraciones vagas.
- Reformula cada afirmación como una oración clara y concisa en español.
- Limita a las 2 a 4 afirmaciones más significativas y verificables.
- Devuelve SOLO un arreglo JSON válido de strings en español. Sin explicación, sin formato markdown.

Ejemplo de salida:
["El crecimiento del PIB de Indonesia alcanzó el 5.1% en el Q3 2025.", "La OMS declaró al mpox una emergencia de salud global en agosto de 2024."]`,

  pt: `Você é um assistente profissional de verificação de fatos. Sua tarefa é extrair alegações factuais específicas e verificáveis do seguinte texto.

Regras:
- Inclua apenas alegações que podem ser verificadas contra fontes externas (estatísticas, eventos, atribuições, declarações científicas).
- Cada alegação deve ser independente (compreensível sem o texto circundante).
- NÃO inclua opiniões, previsões, perguntas retóricas ou declarações vagas.
- Reformule cada alegação como uma frase clara e concisa em português.
- Limite às 2 a 4 alegações mais significativas e verificáveis.
- Retorne APENAS um array JSON válido de strings em português. Sem explicação, sem formato markdown.

Exemplo de saída:
["O crescimento do PIB da Indonésia atingiu 5,1% no Q3 de 2025.", "A OMS declarou o mpox uma emergência de saúde global em agosto de 2024."]`,

  jv: `Sampeyan yaiku asisten pemeriksa fakta profesional. Tugas sampeyan yaiku nyupilake klaim faktual spesifik sing bisa diverifikasi saka teks ing ngisor iki.

Aturan:
- Mung sertakake klaim sing bisa diverifikasi nganggo sumber eksternal (statistik, peristiwa, pernyataan tokoh, fakta ilmiah).
- Saben klaim kudu bisa ngerti awake dhewe tanpa maca kabeh teks.
- Aja nyertakake opini, prediksi, pertanyaan retoris, utawa klaim samar.
- Nulis maneh saben klaim dadi kalimat sing cetha lan tepat ing Basa Jawa.
- Watesi nganti 2–4 klaim paling signifikan lan penting.
- Mung baliakna JSON array of strings ing Basa Jawa. Tanpa panjelasan tambahan, tanpa format markdown.

Contoh output:
["Pertumbuhan PDB Indonesia tekan 5,1% ing Q3 2025.", "WHO ngandhakake mpox minangka darurat kesehatan global ing Agustus 2024."]`,

  su: `Anjeun nyaéta asisten panyodor fakta profésional. Tugas anjeun nyaéta nyandak klaim fakta spésifik anu tiasa diverifikasi tina téks ieu handap.

Aturan:
- Nyandak ukur klaim anu tiasa diverifikasi ngalangkungan sumber éksternal (statistik, kajadian, pernyataan tokoh, fakta ilmiah).
- Unggal klaim kedah mandiri (tiasa dipikahami tanpa ngalérkeun sadaya téks).
- Ulah nyandak opini, prediksi, patarosan rétoris, atanapi klaim gemet.
- Nulis deui unggal klaim janten kalimat anu jelas sareng jangkung dina Basa Sunda.
- Watesan ka 2–4 klaim anu paling penting sareng tiasa diverifikasi.
- Ulah ukur mulangkeun JSON array of strings dina Basa Sunda. Tanpa panjelasan, tanpa format markdown.

Conto hasil:
["Tumuwuhna PDB Indonesia nepi 5.1% dina Q3 2025.", "WHO nyarioskeun mpox minangka kaayaan darurat kaséhatan global dina Agustus 2024."]",
};

/**
 * Uses the configured LLM to extract checkable claims from text.
 * @param {string} text  The article body or transcript chunk.
 * @param {string} [lang='id']
 * @returns {Promise<string[]>}  Array of claim strings.
 */
export async function extractClaims(text, lang = 'id') {
  const truncated = text.length > 12000 ? text.slice(0, 12000) + '\n[…text truncated…]' : text;
  const basePrompt = CLAIM_EXTRACTION_PROMPTS[lang] || CLAIM_EXTRACTION_PROMPTS.id;
  const label = lang === 'en' ? 'Text to analyze' :
    lang === 'id' ? 'Teks yang dianalisis' :
    lang === 'ja' ? '分析対象テキスト' :
    lang === 'ko' ? '분석할 텍스트' :
    lang === 'zh' ? '待分析文本' :
    lang === 'ar' ? 'النص المراد تحليله' :
    lang === 'es' ? 'Texto a analizar' :
    lang === 'pt' ? 'Texto para analisar' :
    lang === 'jv' ? 'Teks kanggo dianalisis' :
    lang === 'su' ? 'Teks anu dipilarian' : 'Text to analyze';
  const prompt = basePrompt + `\n\n${label}:\n"""\n${truncated}\n"""`;

  const content = await callLLM(prompt, 0.2, 2048);

  try {
    const claims = parseJSON(content);
    if (!Array.isArray(claims) || claims.length === 0) {
      throw new Error('Parsed result is not a non-empty array.');
    }
    const filtered = claims.filter((c) => typeof c === 'string' && c.trim().length >= 10);
    return filtered.slice(0, 3);
  } catch (parseErr) {
    console.warn('[Aletheia] Failed to parse claims JSON, attempting line-split fallback:', parseErr);
    const lines = content
      .split('\n')
      .map((l) => l.replace(/^[\d\-\.\)\*]+\s*/, '').trim())
      .filter((l) => l.length >= 10);
    if (lines.length === 0) {
      throw new Error('Could not parse any claims from LLM response.');
    }
    return lines.slice(0, 3);
  }
}

// ─── Stage 2: Evidence Retrieval ──────────────────────────────────────────────

/**
 * Calls Tavily Search API to retrieve ground-truth snippets for a claim.
 * @param {string} claim
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
 */
export async function retrieveEvidence(claim) {
  const { tavilyKey } = await getSettings();

  if (!tavilyKey) {
    return retrieveEvidenceViaProxy(claim);
  }

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: tavilyKey,
      query: claim,
      search_depth: 'basic',
      max_results: 3,
      include_answer: false,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Tavily API error (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const results = data.results || [];

  return results.map((r) => ({
    title: r.title || 'Untitled',
    url: r.url || '',
    snippet: r.content || r.snippet || '',
  }));
}

// ─── Stage 3: Verdict Generation ─────────────────────────────────────────────

const VERDICT_PROMPTS = {
  id: `Anda adalah seorang pemeriksa fakta yang independen dan teliti. Evaluasi klaim berikut berdasarkan HANYA bukti-bukti yang disediakan di bawah ini. JANGAN menggunakan pengetahuan di luar bukti yang diberikan.

Klaim yang diperiksa:
"{CLAIM}"

Bukti-bukti sumber:
{EVIDENCE}

Tuliskan respons Anda HANYA dalam format JSON valid (tanpa blok markdown \`\`\`json, tanpa teks tambahan):
{
  "verdict": "True" | "False" | "Misleading" | "Unverified",
  "explanation": "Penjelasan ringkas 2 sampai 3 kalimat dalam Bahasa Indonesia yang logis dan jelas mengenai alasan verifikasi berdasarkan bukti yang ditemukan.",
  "confidence": "High" | "Medium" | "Low",
  "key_sources": ["url1", "url2"]
}

Aturan Sangat Penting:
1. Bidang "explanation" WAJIB ditulis sepenuhnya dalam Bahasa Indonesia yang baku, jelas, dan profesional.
2. Bidang "verdict" WAJIB memilih salah satu dari nilai persis berikut: "True", "False", "Misleading", atau "Unverified".
3. Bidang "confidence" WAJIB memilih salah satu dari: "High", "Medium", atau "Low".
4. Sertakan URL sumber utama yang relevan pada bidang "key_sources".`,

  en: `You are a rigorous, independent fact-checker. Evaluate the following claim based ONLY on the evidence provided below. Do NOT use your own training knowledge. Ground your verdict strictly in the supplied sources.

Claim:
"{CLAIM}"

Evidence:
{EVIDENCE}

Respond with ONLY valid JSON (no markdown fences, no extra text):
{
  "verdict": "True" | "False" | "Misleading" | "Unverified",
  "explanation": "Write a 2 to 3 sentence explanation of your reasoning in clear, natural English, referencing specific sources",
  "confidence": "High" | "Medium" | "Low",
  "key_sources": ["url1", "url2"]
}

Important:
1. Write the "explanation" value in clear English.
2. Keep "verdict" strictly as one of: "True", "False", "Misleading", or "Unverified".
3. Keep "confidence" strictly as one of: "High", "Medium", or "Low".
4. Include relevant source URLs in "key_sources".`,

  ja: `あなたは厳格で独立したファクトチェッカーです。以下の証拠のみに基づいて、次のクライアントを評価してください。独自のトレーニング知識は使用しないでください。提供されたソースのみに基づいて判断してください。

クライアント:
"{CLAIM}"

証拠:
{EVIDENCE}

有効なJSONのみを返してください（マークダウ fenceや余分なテキストなし）:
{
  "verdict": "True" | "False" | "Misleading" | "Unverified",
  "explanation": "2〜3文で明確に推論を説明し、具体的なソースを参照してください",
  "confidence": "High" | "Medium" | "Low",
  "key_sources": ["url1", "url2"]
}

重要:
1. "explanation"は明確な日本語で記述してください。
2. "verdict"は厳密に次のいずれかのみ: "True", "False", "Misleading", "Unverified"。
3. "confidence"は厳密に次のいずれかのみ: "High", "Medium", "Low"。
4. 関連するソースURLを"key_sources"に含めてください。`,

  ko: `당신은 엄격하고 독립적인 팩트체커입니다. 다음 증거만을 기반으로 다음 주장을 평가하세요. 자체 학습 지식을 사용하지 마세요. 제공된 소스만을 기반으로 판단하세요.

주장:
"{CLAIM}"

증거:
{EVIDENCE}

유효한 JSON만 반환하세요 (마크다운 fence 없음, 추가 텍스트 없음):
{
  "verdict": "True" | "False" | "Misleading" | "Unverified",
  "explanation": "2~3문장으로 명확하게 추론을 설명하고 구체적인 소스를 참조하세요",
  "confidence": "High" | "Medium" | "Low",
  "key_sources": ["url1", "url2"]
}

중요:
1. "explanation"은 명확한 한국어로 작성하세요.
2. "verdict"은 엄격히 다음 중 하나: "True", "False", "Misleading", "Unverified".
3. "confidence"은 엄격히 다음 중 하나: "High", "Medium", "Low".
4. 관련 소스 URL을 "key_sources"에 포함하세요.`,

  zh: `您是严格的独立事实核查员。仅根据以下提供的证据评估以下陈述。不要使用您自己的训练知识。严格基于提供的来源做出判定。

陈述:
"{CLAIM}"

证据:
{EVIDENCE}

仅返回有效的JSON（无markdown fence，无额外文本）:
{
  "verdict": "True" | "False" | "Misleading" | "Unverified",
  "explanation": "用清晰的中文写2-3句话解释您的推理，引用具体来源",
  "confidence": "High" | "Medium" | "Low",
  "key_sources": ["url1", "url2"]
}

重要:
1. "explanation"用清晰的中文书写。
2. "verdict"严格限于以下之一: "True", "False", "Misleading", "Unverified"。
3. "confidence"严格限于以下之一: "High", "Medium", "Low"。
4. 在"key_sources"中包含相关的来源URL。`,

  ar: `أنت فاحص حقائق صارم ومستقل. قيم الادعاء التالي بناءً على الأدلة المقدمة أدناه فقط. لا تستخدم معرفك التدريبي الخاص. احكم بناءً على المصادر المقدمة فقط.

الادعاء:
"{CLAIM}"

الأدلة:
{EVIDENCE}

أعد فقط JSON صالح (بدون علامات markdown، بدون نص إضافي):
{
  "verdict": "True" | "False" | "Misleading" | "Unverified",
  "explanation": "اكتب جملتين إلى ثلاث جمل توضيحية بأعلى جودة بالعربية، مع الإشارة إلى مصادر محددة",
  "confidence": "High" | "Medium" | "Low",
  "key_sources": ["url1", "url2"]
}

مهم:
1. اكتب قيمة "explanation" بجودة عالية بالعربية.
2. احتفظ بـ "verdict" بشكل صارم كأحد: "True", "False", "Misleading", "Unverified".
3. احتفظ بـ "confidence" بشكل صارم كأحد: "High", "Medium", "Low".
4. قم بتضمين روابط المصادر ذات الصلة في "key_sources".`,

  es: `Eres un verificador de hechos riguroso e independiente. Evalúa la siguiente afirmación basándote SOLAMENTE en la evidencia proporcionada a continuación. NO uses tu propio conocimiento de entrenamiento. Fundamenta tu veredicto estrictamente en las fuentes proporcionadas.

Afirmación:
"{CLAIM}"

Evidencia:
{EVIDENCE}

Responde SOLAMENTE con JSON válido (sin cercas markdown, sin texto extra):
{
  "verdict": "True" | "False" | "Misleading" | "Unverified",
  "explanation": "Escribe una explicación de 2 a 3 oraciones de tu razonamiento en español claro, haciendo referencia a fuentes específicas",
  "confidence": "High" | "Medium" | "Low",
  "key_sources": ["url1", "url2"]
}

Importante:
1. Escribe el valor de "explanation" en español claro.
2. Mantén "verdict" estrictamente como uno de: "True", "False", "Misleading" o "Unverified".
3. Mantén "confidence" estrictamente como uno de: "High", "Medium" o "Low".
4. Incluye URLs de fuentes relevantes en "key_sources".`,

  pt: `Você é um verificador de fatos rigoroso e independente. Avalie a seguinte alegação com base APENAS nas evidências fornecidas abaixo. NÃO use seu próprio conhecimento de treinamento. Fundamente seu veredicto estritamente nas fontes fornecidas.

Alegação:
"{CLAIM}"

Evidências:
{EVIDENCE}

Responda APENAS com JSON válido (sem cercas markdown, sem texto extra):
{
  "verdict": "True" | "False" | "Misleading" | "Unverified",
  "explanation": "Escreva uma explicação de 2 a 3 frases do seu raciocínio em português claro, referenciando fontes específicas",
  "confidence": "High" | "Medium" | "Low",
  "key_sources": ["url1", "url2"]
}

Importante:
1. Escreva o valor de "explanation" em português claro.
2. Mantenha "verdict" estritamente como um de: "True", "False", "Misleading" ou "Unverified".
3. Mantenha "confidence" estritamente como um de: "High", "Medium" ou "Low".
4. Inclua URLs de fontes relevantes em "key_sources".`,

  jv: `Sampeyan yaiku pemeriksa fakta sing ketat lan mandiri. Evaluasi klaim ing ngisor iki mung ing dhasar bukti sing disedhiyakake ing ngisor iki. Aja nggunakake kawruh pelatihan sampeyan dhewe. Gawe putusan sampeyan kanthi ketat ing dhasar sumber sing diwenehake.

Klaim:
"{CLAIM}"

Bukti:
{EVIDENCE}

Baliakna mung JSON valid (tanpa fence markdown, tanpa teks tambahan):
{
  "verdict": "True" | "False" | "Misleading" | "Unverified",
  "explanation": "Nulis panjelasan 2 nganti 3 kalimat bab alasane sampeyan ing Basa Jawa sing cetha, ngrujuk sumber tartamtu",
  "confidence": "High" | "Medium" | "Low",
  "key_sources": ["url1", "url2"]
}

Penting:
1. Nulis nilai "explanation" ing Basa Jawa sing cetha.
2. Tansah "verdict" kanthi ketat minangka salah sawijining: "True", "False", "Misleading", utawa "Unverified".
3. Tansah "confidence" kanthi ketat minangka salah sawijining: "High", "Medium", utawa "Low".
4. Sertakake URL sumber sing relevan ing "key_sources".`,

  su: `Anjeun nyaéta panyodor fakta anu ketat sareng mandiri. Nilik klaim ieu handap ngan dumasar kana bukti anu disayogikeun di handap. Ulah ngagunakeun kaweruh latihan anjeun nyalira. Jantenkeun putusan anjeun ketat dumasar kana sumber anu disayogikeun.

Klaim:
"{CLAIM}"

Bukti:
{EVIDENCE}

Mulangkeun ukur JSON anu sah (tanpa pagar markdown, tanpa téks tambahan):
{
  "verdict": "True" | "False" | "Misleading" | "Unverified",
  "explanation": "Nulis panjelasan 2 dugi 3 kalimat ngeunaan rasionales anjeun dina Basa Sunda anu jelas, nyarioskeun sumber anu tangtu",
  "confidence": "High" | "Medium" | "Low",
  "key_sources": ["url1", "url2"]
}

Penting:
1. Nulis nilai "explanation" dina Basa Sunda anu jelas.
2. Tetep "verdict" ketat salaku salah sahiji: "True", "False", "Misleading", atanapi "Unverified".
3. Tetep "confidence" ketat salaku salah sahiji: "High", "Medium", atanapi "Low".
4. kalebetkeun URL sumber anu aya patalina dina "key_sources".`,
};

const NO_EXPLANATION = {
  id: 'Tidak ada penjelasan yang diberikan.',
  en: 'No explanation provided.',
  ja: '説明が提供されていません。',
  ko: '설명이 제공되지 않았습니다.',
  zh: '未提供解释。',
  ar: 'لم يتم تقديم شرح.',
  es: 'No se proporcionó explicación.',
  pt: 'Nenhuma explicação fornecida.',
  jv: 'Ora ana panjelasan sing diwenehake.',
  su: 'Teu aya panjelasan anu disayogikeun.',
};

const PARSE_ERROR = {
  id: 'Tidak dapat memproses hasil pemeriksaan fakta.',
  en: 'Could not parse the fact-check result.',
  ja: 'ファクトチェック結果を解析できませんでした.',
  ko: '팩트체크 결과를 분석할 수 없습니다.',
  zh: '无法解析事实核查结果。',
  ar: 'تعذر تحليل نتيجة فحص الحقائق.',
  es: 'No se pudo analizar el resultado de la verificación.',
  pt: 'Não foi possível analisar o resultado da verificação.',
  jv: 'Ora bisa menganalisis asil pemeriksaan fakta.',
  su: 'Teu tiasa ngaluarkeun hasil panyodoran fakta.',
};

/**
 * Generates a grounded verdict for a single claim.
 * @param {string} claim
 * @param {Array<{title: string, url: string, snippet: string}>} evidence
 * @param {string} [lang='id']
 * @returns {Promise<{verdict: string, explanation: string, confidence: string, key_sources: string[]}>}
 */
export async function generateVerdict(claim, evidence, lang = 'id') {
  const evidenceText =
    evidence.length > 0
      ? evidence
          .map((e, i) => `[${i + 1}] ${e.title}\n    URL: ${e.url}\n    "${e.snippet}"`)
          .join('\n\n')
      : '(No evidence was found for this claim.)';

  const basePrompt = VERDICT_PROMPTS[lang] || VERDICT_PROMPTS.id;
  const prompt = basePrompt.replace('{CLAIM}', claim).replace('{EVIDENCE}', evidenceText);

  const content = await callLLM(prompt, 0.1, 1024);

  try {
    const verdict = parseJSON(content);
    const validVerdicts = ['True', 'False', 'Misleading', 'Unverified'];
    if (!validVerdicts.includes(verdict.verdict)) {
      verdict.verdict = 'Unverified';
    }
    return {
      verdict: verdict.verdict,
      explanation: verdict.explanation || NO_EXPLANATION[lang] || NO_EXPLANATION.id,
      confidence: verdict.confidence || 'Low',
      key_sources: Array.isArray(verdict.key_sources) ? verdict.key_sources : [],
    };
  } catch (parseErr) {
    console.warn('[Aletheia] Failed to parse verdict JSON:', parseErr, content);
    return {
      verdict: 'Unverified',
      explanation: PARSE_ERROR[lang] || PARSE_ERROR.id,
      confidence: 'Low',
      key_sources: [],
    };
  }
}
