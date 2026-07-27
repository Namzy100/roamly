import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown while persisted trips are being read out of localStorage.
 *
 * Mirrors the real workspace's layout closely enough that the swap does not
 * shift the page, which is the whole point of a skeleton over a spinner.
 */
export function WorkspaceSkeleton() {
  return (
    <div className="flex flex-1 flex-col" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your trip…</span>

      <header className="flex flex-col gap-6 border-b border-line bg-cream-raised/60 px-5 pt-6 pb-7 sm:px-8">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-12 w-full rounded-xl" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-10 w-3/4 max-w-lg" />
          <Skeleton className="h-4 w-56" />
          <div className="flex gap-1.5">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        </div>
      </header>

      <div className="border-b border-line px-5 py-3 sm:px-8">
        <div className="mx-auto flex w-full max-w-[1600px] gap-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-20 shrink-0 rounded-xl" />
          ))}
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-6 px-5 py-6 sm:px-8 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(24rem,26rem)] lg:items-start lg:gap-8">
        <div className="flex min-w-0 flex-col gap-4">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-full max-w-xl" />
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-40 w-full rounded-2xl" />
          ))}
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Skeleton className="h-[30rem] w-full rounded-2xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
