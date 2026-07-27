import { Compass } from "lucide-react";
import Link from "next/link";

import { SiteFooter, SiteHeader } from "@/components/shell/site-chrome";

/** Global 404 for any unmatched URL, styled rather than left to the default. */
export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="flex flex-1 items-center justify-center px-5 py-24 sm:px-8">
        <div className="flex max-w-md flex-col items-center gap-5 text-center">
          <span className="eyebrow text-terracotta">Error 404</span>
          <h1 className="font-display text-4xl leading-tight text-forest">
            This route doesn&apos;t exist
          </h1>
          <p className="text-sm leading-relaxed text-ink-muted text-pretty">
            The page you were looking for isn&apos;t here. Start a new plan and
            we&apos;ll get you somewhere better.
          </p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-full bg-forest px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-forest-soft"
          >
            <Compass aria-hidden className="size-4" />
            Back to Roamly
          </Link>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
