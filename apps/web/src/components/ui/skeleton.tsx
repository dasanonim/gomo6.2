import { cn } from "@/lib/utils";

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Static placeholders avoid a pulse competing with entrance choreography. */
  pulse?: boolean;
}

function Skeleton({ className, pulse = true, ...props }: SkeletonProps) {
  return <div className={cn(pulse && "animate-pulse", "rounded-md bg-muted", className)} {...props} />;
}

export { Skeleton };
