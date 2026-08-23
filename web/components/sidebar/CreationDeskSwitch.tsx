"use client"

import Link from "next/link"
import { Clapperboard, Images, PenLine } from "lucide-react"
import { usePathname } from "next/navigation"
import { useTranslation } from "react-i18next"
import { creationDeskNavState } from "@/lib/creation-desk-nav"

const ITEMS = [
  { href: "/co-writer", label: "Co-Writer", icon: PenLine, child: "write" as const },
  { href: "/image-studio", label: "Image Studio", icon: Images, child: "image" as const },
  { href: "/video-studio", label: "Video Studio", icon: Clapperboard, child: "video" as const },
]

export function CreationDeskSwitch() {
  const pathname = usePathname()
  const { t } = useTranslation()
  const current = creationDeskNavState(pathname).child
  return (
    <div data-creation-desk-switch="" className="inline-flex items-center gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--muted)]/40 p-0.5">
      {ITEMS.map(item => {
        const active = current === item.child
        return (
          <Link
            key={item.href}
            href={item.href}
            title={t(item.label)}
            aria-current={active ? "page" : undefined}
            className={`inline-flex h-7 items-center gap-1 rounded-[10px] px-2 text-[11px] ${
              active
                ? "bg-[var(--background)] font-medium text-[var(--foreground)] shadow-sm"
                : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            }`}
          >
            <item.icon size={13} strokeWidth={active ? 2 : 1.6} />
            <span className="hidden sm:inline">{t(item.label)}</span>
          </Link>
        )
      })}
    </div>
  )
}
