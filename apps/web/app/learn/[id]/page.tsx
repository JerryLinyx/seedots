import { Suspense } from "react";
import { LearnView } from "@/components/LearnView";

export default async function Learn({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <LearnView mediaId={id} />
    </Suspense>
  );
}
