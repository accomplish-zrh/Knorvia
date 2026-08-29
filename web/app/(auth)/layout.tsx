export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-[var(--background)]">
      <div
        data-desktop-drag=""
        aria-hidden
        className="desktop-drag-hit absolute inset-x-0 top-0 h-9"
      />
      {children}
    </div>
  );
}
