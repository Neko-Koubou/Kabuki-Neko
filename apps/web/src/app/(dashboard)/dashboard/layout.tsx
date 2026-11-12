/**
 * Dashboard layout (SA §1.2, Design §1.1; TASK-132): wraps every `/dashboard/*` page in the
 * protected `DashboardShell` (session check before any content, role-based navigation, skip link,
 * responsive sidebar/menu, legal footer). The locale, theme and auth providers come from the root
 * layout, so they are not remounted here.
 */
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/ui/dashboard-shell";

/** Private pages are never indexed. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Protected dashboard frame around the dashboard pages. */
export default function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <DashboardShell>{children}</DashboardShell>;
}
