import { ButtonLink, Empty } from "@/components/ui";

export default function NotFound() {
  return (
    <Empty title="Not found">
      That alert, case or customer does not exist in this workspace. It may have been cleared by a workspace reset.
      <div className="mt-4"><ButtonLink href="/">Back to dashboard</ButtonLink></div>
    </Empty>
  );
}
