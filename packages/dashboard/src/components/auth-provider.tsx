"use client";

import { SessionProvider } from "next-auth/react";
import { LocaleProvider } from "./locale-provider";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <LocaleProvider>{children}</LocaleProvider>
    </SessionProvider>
  );
}
