import { Suspense } from "react";
import { BotsView } from "@/components/native/BotsView";

export default function BotsPage() {
  return <Suspense fallback={null}><BotsView /></Suspense>;
}
