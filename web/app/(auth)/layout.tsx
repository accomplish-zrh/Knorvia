export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[var(--background)] px-4">
      <div aria-hidden className="auth-aura pointer-events-none absolute inset-0" />
      <div
        data-desktop-drag=""
        aria-hidden
        className="desktop-drag-hit absolute inset-x-0 top-0 h-9"
      />
      <div className="relative z-[1] w-full max-w-sm">{children}</div>
    </div>
  );
}
