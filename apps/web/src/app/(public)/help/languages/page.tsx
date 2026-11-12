/**
 * Public `/help/languages` (SA §8.2, Design §4.5; TASK-149): how to add a language package, with the
 * real translation template download and the installed languages, inside the public shell.
 */
import { LanguageGuide } from "@/components/ui/document-view";
import { PublicShell } from "@/components/ui/public-shell";

/** Language guide page. */
export default function LanguageGuidePage() {
  return (
    <PublicShell>
      <LanguageGuide />
    </PublicShell>
  );
}
