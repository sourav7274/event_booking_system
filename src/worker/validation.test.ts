import { describe, expect, it } from 'vitest';
import { bookingSchema, createEventSchema, updateEventSchema } from './validation';

describe('API boundary validation', () => {
  it('accepts a bounded ticket quantity', () => {
    expect(bookingSchema.parse({ quantity: 10 })).toEqual({ quantity: 10 });
  });

  it('rejects ticket quantities outside the permitted range', () => {
    expect(() => bookingSchema.parse({ quantity: 11 })).toThrow();
    expect(() => bookingSchema.parse({ quantity: 0 })).toThrow();
  });

  it('requires an event end time after its start time', () => {
    expect(() => createEventSchema.parse({
      title: 'Community Night', description: 'A long enough event description.', venue: 'Main Hall',
      startsAt: '2030-01-01T20:00:00.000Z', endsAt: '2030-01-01T19:00:00.000Z',
      capacity: 100, priceMinor: 2500, currency: 'usd',
    })).toThrow();
  });

  it('does not allow an empty event patch', () => {
    expect(() => updateEventSchema.parse({})).toThrow();
  });
});
