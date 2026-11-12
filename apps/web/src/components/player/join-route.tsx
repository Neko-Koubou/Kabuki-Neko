"use client";
/**
 * Client entry of the `/join` route (TASK-151): mounts the guest join flow with Next navigation, so
 * a successful join (or rejoin) moves to the game screen without a full page load.
 */
import { useRouter } from "next/navigation";
import { PinJoinScanner } from "@/components/player/pin-join-scanner";

/** Join flow wired to the router. */
export function JoinRoute({ initialPin }: { initialPin: string | null }) {
  const router = useRouter();
  return <PinJoinScanner initialPin={initialPin} navigate={(href) => router.push(href)} />;
}
