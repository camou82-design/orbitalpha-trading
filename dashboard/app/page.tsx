import HomePageClient from "./home-page-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function HomePage() {
  return <HomePageClient />;
}
