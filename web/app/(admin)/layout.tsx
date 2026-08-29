export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-h-screen bg-[var(--background)]">
      <div
        data-desktop-drag=""
        aria-hidden
        className="desktop-drag-hit absolute inset-x-0 top-0 h-9"
      />
      {children}
    </div>
  );
}
