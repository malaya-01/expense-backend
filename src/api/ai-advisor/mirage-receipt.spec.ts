import {
  amountAppearsIn,
  mirageFieldsToReceiptJson,
  transcriptCanReplaceImage,
} from './mirage-receipt';

describe('Mirage receipt gate', () => {
  const transcript = [
    'DMART',
    'Invoice 1842',
    'Milk 42.00',
    'Grand Total 1,250.50',
    'Paid via UPI',
  ].join('\n');

  it('accepts a transcript that can replace the image', () => {
    expect(transcriptCanReplaceImage(transcript)).toBe(true);
    expect(transcriptCanReplaceImage('ok')).toBe(false);
    expect(transcriptCanReplaceImage('no digits here at all today')).toBe(false);
  });

  it('accepts an amount only when those digits are printed', () => {
    expect(amountAppearsIn(1250.5, transcript)).toBe(true);
    expect(amountAppearsIn(1250.5, 'Grand Total 1250.50')).toBe(true);
    expect(amountAppearsIn(99, transcript)).toBe(false);
    expect(amountAppearsIn(42, transcript)).toBe(true);
  });

  it('keeps a grounded local read and drops an invented total', () => {
    expect(
      mirageFieldsToReceiptJson({
        text: transcript,
        fields: { merchant: 'DMART', grand_total: 1250.5, currency: 'INR' },
      }),
    ).toMatchObject({ merchant: 'DMART', grand_total: 1250.5, amount: 1250.5 });

    expect(
      mirageFieldsToReceiptJson({
        text: transcript,
        fields: { merchant: 'DMART', grand_total: 9999 },
      }),
    ).toBeNull();
  });
});
