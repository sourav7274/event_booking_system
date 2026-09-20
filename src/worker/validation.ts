import { z } from 'zod';

const isoDate = z.string().datetime({ offset: true });

const eventFields = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(2_000),
  venue: z.string().trim().min(2).max(160),
  startsAt: isoDate,
  endsAt: isoDate,
  capacity: z.number().int().min(1).max(100_000),
  priceMinor: z.number().int().min(0).max(10_000_000),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  status: z.enum(['DRAFT', 'PUBLISHED']).default('DRAFT'),
});

export const createEventSchema = eventFields.superRefine((value, ctx) => {
  if (new Date(value.endsAt) <= new Date(value.startsAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endsAt'], message: 'End time must be after start time.' });
  }
});

export const updateEventSchema = eventFields.partial().extend({
  status: z.enum(['DRAFT', 'PUBLISHED', 'CANCELLED']).optional(),
}).refine((value) => Object.keys(value).length > 0, 'Provide at least one editable field.');

export const bookingSchema = z.object({
  quantity: z.number().int().min(1).max(10),
});

export const eventListSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  q: z.string().trim().max(80).optional(),
  from: isoDate.optional(),
});
