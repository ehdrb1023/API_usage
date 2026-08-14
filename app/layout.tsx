import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "API 비용 대시보드",
  description: "Claude · Vercel 사용량과 비용을 한 화면에서 본다",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
