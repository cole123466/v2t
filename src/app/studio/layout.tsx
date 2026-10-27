import { StudioShell } from "@/components/studio/studio-shell";

export default function StudioLayout({ children }: LayoutProps<"/studio">) {
  return <StudioShell>{children}</StudioShell>;
}
