import { notFound } from "next/navigation";

import { ClaimDetailBody } from "@/components/claim-detail-body";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { safeDecodeURIComponent } from "@/lib/claim-href";
import { getClaimDetail } from "@/lib/db";

export const dynamic = "force-dynamic";

interface ClaimDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function ClaimDetailPage({ params }: ClaimDetailPageProps) {
  const { id } = await params;
  const decoded = safeDecodeURIComponent(id);
  if (decoded == null) {
    notFound();
  }
  const claim = await getClaimDetail(decoded);
  if (!claim) {
    notFound();
  }

  return (
    <div className="w-full px-4 md:px-8 lg:px-12 py-8">
      <Breadcrumb
        items={[
          { label: "Claims", href: "/claims" },
          { label: claim.topic ?? claim.id },
        ]}
      />
      <ClaimDetailBody claim={claim} />
    </div>
  );
}
