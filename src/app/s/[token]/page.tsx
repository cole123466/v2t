import type { Metadata } from "next";
import { SharedRecord } from "@/components/share/shared-record";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // 公开只读页：不进搜索引擎索引
  robots: { index: false, follow: false },
};

/** /s/{token}：单篇只读分享页。token 即全部凭据，页面不消费设备 cookie。 */
export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <main className="mx-auto w-full max-w-[60rem] px-4 py-8 sm:px-6">
      <SharedRecord token={token} />
    </main>
  );
}
