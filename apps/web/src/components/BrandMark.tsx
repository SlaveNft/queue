import clsx from "clsx";

interface BrandMarkProps {
  className?: string;
  tone?: "ink" | "lime";
}

export function BrandMark({ className, tone = "ink" }: BrandMarkProps) {
  return (
    <span className={clsx("brand-mark", className)} data-tone={tone} aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
