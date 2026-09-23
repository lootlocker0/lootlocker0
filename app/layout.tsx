import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // The fallback for any route that cannot export its own metadata — notably
  // /order/[orderNumber], which must be a Client Component (the receipt
  // cookie is Path=/api/orders, unreadable by a Server Component) and so
  // falls back to this default for its browser tab and bookmark title. That
  // is the one page students are told to screenshot and keep, so this must
  // never regress to a scaffold placeholder (docs/HANDOFF.md #73).
  title: "LootLockers",
  description:
    "School snack ordering with locker pickup. Order ahead, skip the line, grab your loadout between classes.",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <link rel="icon" href="/favicon.ico" />
        <link rel="shortcut icon" href="/favicon.ico" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {/* Matches --color-void (app/globals.css) — the app's canvas is
            near-black, so a mobile browser's chrome should be too, not the
            create-next-app default white (docs/HANDOFF.md #74). */}
        <meta name="theme-color" content="#07070F" />
      </head>
      <body suppressHydrationWarning className="min-h-full flex flex-col">
        {children}
      </body>
    </html>
  );
}
