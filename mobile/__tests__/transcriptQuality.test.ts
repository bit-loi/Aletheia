import {isCheckableTranscript} from '../src/transcriptQuality';

describe('isCheckableTranscript', () => {
  it.each(['', '   ', 'パイ4000', 'hello', 'two words'])('rejects noisy fragment %p', text => {
    expect(isCheckableTranscript(text)).toBe(false);
  });

  it.each([
    'The Earth revolves around the Sun.',
    '東京は日本の首都です。',
    '北京是中国的首都。',
    '대한민국의 수도는 서울입니다.',
    'Jakarta adalah ibu kota Indonesia.',
  ])('accepts a checkable statement %p', text => {
    expect(isCheckableTranscript(text)).toBe(true);
  });
});
