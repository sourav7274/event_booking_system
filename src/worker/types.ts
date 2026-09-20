export type Role = 'CUSTOMER' | 'ORGANIZER';
export type AppEnvironment = 'production' | 'baseline' | 'test';

export interface Env {
  DB: D1Database;
  JOBS: Queue<JobMessage>;
  ASSETS: Fetcher;
  APP_ENV: AppEnvironment;
  APP_ORIGIN: string;
  CLERK_ISSUER: string;
  CLERK_AUDIENCE: string;
  CLERK_JWT_PUBLIC_KEY?: string;
  ORGANIZER_CLERK_IDS: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM: string;
  BENCHMARK_SECRET?: string;
}

export interface AuthUser {
  clerkId: string;
  email: string;
  role: Role;
}

export type JobMessage =
  | { type: 'BOOKING_CONFIRMATION'; outboxId: string }
  | { type: 'EVENT_UPDATE'; outboxId: string };

export interface EventRow {
  id: string;
  organizer_id: string;
  title: string;
  description: string;
  venue: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  tickets_sold: number;
  price_minor: number;
  currency: string;
  status: 'DRAFT' | 'PUBLISHED' | 'CANCELLED';
  version: number;
  created_at: string;
  updated_at: string;
}
