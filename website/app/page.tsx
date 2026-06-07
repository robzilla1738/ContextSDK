import { Nav } from "@/components/Nav";
import { Hero } from "@/components/Hero";
import { Providers } from "@/components/Providers";
import { Features } from "@/components/Features";
import { TwoLayer } from "@/components/TwoLayer";
import { HowItWorks } from "@/components/HowItWorks";
import { CodeShowcase } from "@/components/CodeShowcase";
import { Security } from "@/components/Security";
import { CTA } from "@/components/CTA";
import { Footer } from "@/components/Footer";

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Providers />
        <Features />
        <TwoLayer />
        <HowItWorks />
        <CodeShowcase />
        <Security />
        <CTA />
      </main>
      <Footer />
    </>
  );
}
