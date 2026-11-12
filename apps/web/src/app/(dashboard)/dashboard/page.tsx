/**
 * `/dashboard` entry (SA §1.2; TASK-132): redirects on the server to the quiz library
 * (`/dashboard/quizzes`), so no empty dashboard page ever renders.
 */
import { redirect } from "next/navigation";

/** Server redirect to the default dashboard section. */
export default function DashboardIndexPage(): never {
  redirect("/dashboard/quizzes");
}
