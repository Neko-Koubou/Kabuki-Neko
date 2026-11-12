/**
 * S13 public `/about` (SA §1.2, Design §4.5; TASK-149): version, official license links and text,
 * audio credits and the language guide link inside the public shell. The same AboutDocument is used
 * on the dashboard About page.
 */
import { AboutDocument } from "@/components/ui/document-view";
import { PublicShell } from "@/components/ui/public-shell";

/** Public About page. */
export default function AboutPage() {
  return (
    <PublicShell>
      <AboutDocument />
    </PublicShell>
  );
}
