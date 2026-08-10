export default function SuccessPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-sm rounded-2xl bg-surface p-8 text-center shadow-lg">
        <div className="mb-4 text-4xl">&#x2705;</div>
        <h1 className="mb-2 text-xl font-semibold">Payment Complete</h1>
        <p className="text-muted">
          Your share has been paid successfully. You can close this page.
        </p>
      </div>
    </div>
  );
}
