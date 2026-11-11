/**
 * S12 `/dashboard/users` (SA §1.2, Design §4.5; TASK-148): users and invitations inside the
 * protected dashboard shell. Only superadmins see the panels; the API enforces the same rule.
 */
import { UserInvites } from "@/components/admin/user-invites";

/** Users page. */
export default function UsersPage() {
  return <UserInvites />;
}
