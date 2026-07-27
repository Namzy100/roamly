import { TripBuilderForm } from "@/components/form/trip-builder-form";
import { Hero } from "@/components/marketing/hero";
import { SavedTrips } from "@/components/marketing/saved-trips";
import { SiteFooter, SiteHeader } from "@/components/shell/site-chrome";

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <SavedTrips />
        <section
          id="builder"
          className="mx-auto w-full max-w-4xl scroll-mt-24 px-5 pt-4 pb-20 sm:px-8 sm:pb-28"
        >
          <TripBuilderForm />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
