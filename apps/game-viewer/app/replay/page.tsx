import { Suspense } from "react";
import ReplayClient from "./ReplayClient";

export const dynamic = "force-dynamic";

export default function ReplayPage() {
  return (
    <Suspense
      fallback={
        <div className="grid h-screen place-items-center text-neutral-400">
          Loading replay...
        </div>
      }
    >
      <ReplayClient />
    </Suspense>
  );
}
