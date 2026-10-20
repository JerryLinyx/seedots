import { LearnView } from "@/components/LearnView";

export default async function LearnPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LearnView mediaId={id} />;
}
