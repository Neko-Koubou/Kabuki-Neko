/**
 * S11 `/dashboard/settings` (SA §1.2, Design §4.5; TASK-147): administration settings, storage and
 * health inside the protected dashboard shell. Only superadmins see the panels; the API enforces
 * the same rule.
 */
import { AdminSettingsHealth } from "@/components/admin/admin-settings-health";

/** Settings page. */
export default function SettingsPage() {
  return <AdminSettingsHealth />;
}
