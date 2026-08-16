"use client";

import { useState, useEffect } from "react";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  ExpressCheckoutElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import type { Tab, ReceiptItem } from "@/lib/types";

const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!
);

interface Props {
  tab: Tab;
  items: ReceiptItem[];
  inviteeLabel: string;
  shareAmount: number; // cents - the individual's calculated share
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function CheckoutForm({ amount }: { amount: number }) {
  const stripe = useStripe();
  const elements = useElements();
  const [status, setStatus] = useState<"idle" | "processing" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");
  // Whether a wallet (Apple Pay / Google Pay / Link) is available in this
  // browser. Undefined until the Express Checkout Element reports readiness;
  // we hide the express button + divider entirely when nothing is available.
  const [expressAvailable, setExpressAvailable] = useState(false);

  // Shared confirmation used by both the express wallet button and the card
  // form. With a clientSecret already on <Elements>, confirmPayment collects
  // the details from whichever element the customer used.
  const confirmPayment = async () => {
    if (!stripe || !elements) return;

    setStatus("processing");

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/split/success`,
      },
    });

    if (error) {
      setErrorMessage(error.message || "Payment failed.");
      setStatus("error");
    } else {
      setStatus("success");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await confirmPayment();
  };

  if (status === "success") {
    return (
      <div className="text-center py-8">
        <div className="text-4xl mb-4">&#x2705;</div>
        <h2 className="text-xl font-semibold mb-2">Payment Successful</h2>
        <p className="text-muted">Your share has been paid. You can close this page.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Apple Pay / Google Pay / Link one-tap buttons. Renders only when a
          wallet is available in the current browser (e.g. Apple Pay in Safari
          on a device with a card in Wallet). */}
      <ExpressCheckoutElement
        onConfirm={confirmPayment}
        onReady={({ availablePaymentMethods }) =>
          setExpressAvailable(Boolean(availablePaymentMethods))
        }
      />

      {expressAvailable && (
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs uppercase tracking-wide text-muted">
            or pay with card
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Wallets are handled by the Express Checkout Element above, so hide
            them here to avoid showing Apple Pay / Google Pay twice. */}
        <PaymentElement
          options={{ wallets: { applePay: "never", googlePay: "never" } }}
        />
        {status === "error" && (
          <p className="text-sm text-danger">{errorMessage}</p>
        )}
        <button
          type="submit"
          disabled={!stripe || status === "processing"}
          className="w-full rounded-xl bg-accent py-3 text-sm font-semibold text-white transition-colors hover:bg-accent-light disabled:opacity-50"
        >
          {status === "processing" ? "Processing..." : `Pay ${formatCents(amount)}`}
        </button>
      </form>
    </div>
  );
}

export default function CheckoutClient({ tab, items, inviteeLabel, shareAmount }: Props) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/create-payment-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tab_id: tab.id,
        amount: shareAmount,
        invitee: inviteeLabel,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.clientSecret) {
          setClientSecret(data.clientSecret);
        } else {
          setError(data.error || "Failed to initialize payment.");
        }
      })
      .catch(() => setError("Network error. Please try again."));
  }, [tab.id, shareAmount, inviteeLabel]);

  return (
    <div className="mx-auto min-h-screen max-w-lg px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Pay Your Share</h1>
        <p className="mt-1 text-muted">
          Hi <span className="font-medium text-foreground">{inviteeLabel}</span>,
          you owe{" "}
          <span className="font-semibold text-foreground">
            {formatCents(shareAmount)}
          </span>
        </p>

        {tab.receipt_storage_url && (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium text-accent hover:text-accent-light">
              View Receipt
            </summary>
            <div className="mt-2 overflow-hidden rounded-xl border border-border">
              <img
                src={tab.receipt_storage_url}
                alt="Receipt"
                className="w-full"
              />
            </div>
          </details>
        )}
      </div>

      {/* Receipt Summary */}
      <div className="mb-6 rounded-xl bg-surface p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          Items
        </h2>
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="flex items-center justify-between">
              <span className="text-sm">{item.item_name}</span>
              <span className="text-sm font-medium">
                {formatCents(item.unit_price * item.quantity)}
              </span>
            </div>
          ))}
          <div className="border-t border-border pt-2 mt-2">
            <div className="flex items-center justify-between font-semibold">
              <span>Total</span>
              <span>{formatCents(tab.total_amount)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Payment Form */}
      <div className="rounded-xl bg-surface p-4 shadow-sm">
        {error && (
          <div className="mb-4 rounded-lg bg-danger/10 p-3 text-sm text-danger">
            {error}
          </div>
        )}
        {clientSecret ? (
          <Elements
            stripe={stripePromise}
            options={{
              clientSecret,
              appearance: {
                theme: "stripe",
                variables: {
                  colorPrimary: "#6366f1",
                  borderRadius: "8px",
                },
              },
            }}
          >
            <CheckoutForm amount={shareAmount} />
          </Elements>
        ) : !error ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
