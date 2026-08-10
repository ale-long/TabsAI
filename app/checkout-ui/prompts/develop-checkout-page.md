# Phase 5: Ephemeral UI & Pass-Through Token Auth Specification

## 🎯 Objective
Build a lightweight, mobile-responsive Next.js single-page application (SPA) to handle manual item mapping and native checkout. This application operates via a decoupled architecture, serving as an ephemeral web utility triggered by Discord interactions.

**Key Deliverables:**
1.  Dynamic interceptor route for secure, invisible pass-through authentication.
2.  Interactive drag-and-drop grid for tab organizers to map receipt line items to users.
3.  Standalone invitee checkout page integrating native Stripe Elements (Apple Pay / Google Pay).

---

## 🏗 Architecture & Stack
* **Framework:** Next.js (App Router).
* **Rendering:** Server Components for auth/validation, Client Components for interactive UI.
* **Database/Auth:** Supabase (Service Role key required for server-side token validation).
* **Design Paradigm:** Mobile-first, ultra-fast, zero-friction handoff from Discord.

---

## 📂 File Structure
```text
app/
└── split/
    └── [tab_id]/
        ├── page.tsx              # Server Component (Token Validation & Auth)
        ├── SplitTaggerClient.tsx # Client Component (Drag & Drop UI)
        └── CheckoutClient.tsx    # Client Component (Stripe Elements)