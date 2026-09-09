import Image from "next/image";

/** Use the same full-colour asset in the workbench and desktop resources. */
export function WorkbenchMark({ hero = false }: { hero?: boolean }) {
  return (
    <span className={hero ? "nw-hero-mark" : "nw-mark"} aria-hidden="true">
      <Image src="/logo.png" alt="" width={hero ? 96 : 42} height={hero ? 96 : 42} unoptimized loading="eager" />
    </span>
  );
}
