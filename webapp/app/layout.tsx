import "./globals.css";
import type { ReactNode } from "react";
export const metadata = { title: "Atlas Metadata Spike", description: "Local HBase metadata search" };
export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="en"><body>{children}</body></html>; }
