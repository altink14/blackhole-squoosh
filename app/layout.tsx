import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "blackhole — image compression at the event horizon",
  description:
    "Drop images into the singularity. MozJPEG, libwebp, libavif and OxiPNG run entirely in your browser — nothing is ever uploaded.",
  openGraph: {
    title: "blackhole",
    description:
      "Squoosh-grade image compression, in your browser, around a raytraced black hole.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-black text-foreground">{children}</body>
    </html>
  );
}
