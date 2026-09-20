# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Customers browse published events and book general-admission tickets. Event organizers create, publish, update, and monitor events they own. Evaluators need to exercise the deployed API, background jobs, and performance evidence.

## Product Purpose

Venueflow is an event-booking system that makes a concurrent ticket booking flow demonstrable, auditable, and reliable. Success means an authorized customer can book without inventory corruption, organizers can manage their own events, and both required email workflows complete asynchronously.

## Positioning

The system pairs an atomic booking path with a durable outbox so ticket inventory and notification intent are committed together, while email delivery happens independently.

## Operating Context

Customers generally arrive to find and reserve tickets quickly. Organizers need an operational view of their events and notification progress. The project is also evaluated through documented API calls, deployed behavior, and repeatable stress tests.

## Capabilities and Constraints

- Cloudflare Worker, D1, Queues, Cron Trigger, Clerk, and Resend.
- Roles are CUSTOMER and ORGANIZER; server-side authorization is authoritative.
- General admission only; booking quantity is 1–10.
- Payments, refunds, customer cancellations, seating, and ticket tiers are out of scope.
- The first dashboard view leads with customer booking. This and the Venueflow name are inferred assumptions because the interactive preference prompt was unavailable.

## Evidence on Hand

The task specification supplies required behaviors and constraints. No logo, brand assets, real benchmark results, customer testimonials, prices, or event imagery exist yet; none may be presented as factual.

## Product Principles

- Correct inventory outranks superficial throughput.
- Authorization belongs at every protected API boundary.
- Background work must be observable, retryable, and safe to repeat.
- Performance claims must be measured on the deployed system.

## Accessibility & Inclusion

Keyboard-operable controls, semantic labels, visible focus states, responsive layout, and readable contrast are required.
