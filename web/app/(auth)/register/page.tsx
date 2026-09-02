"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { register, checkIsFirstUser, fetchAuthStatus } from "@/lib/auth";
import BrandMark from "@/components/common/BrandMark";

export default function RegisterPage() {
  const { t } = useTranslation();
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [isFirst, setIsFirst] = useState(false);
  const [checkingFirst, setCheckingFirst] = useState(true);

  useEffect(() => {
    // Redirect if already logged in
    fetchAuthStatus().then((status) => {
      if (status?.authenticated) router.replace("/");
    });

    // Check if this will be the first (admin) user
    checkIsFirstUser().then((first) => {
      setIsFirst(first);
      setCheckingFirst(false);
    });
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError(t("Passwords do not match"));
      return;
    }

    setLoading(true);
    const result = await register(username, password);

    if (result.ok) {
      router.replace("/login?registered=1");
    } else {
      setError(result.error ?? t("Registration failed"));
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 flex flex-col items-center text-center">
        <BrandMark size="hero" alt="" priority />
        <h1 className="mt-4 font-serif text-2xl font-semibold tracking-tight text-[var(--foreground)]">
          {t("Knorvia")}
        </h1>
        <p className="mt-1.5 text-sm text-[var(--muted-foreground)]">
          {t("Create your account")}
        </p>
      </div>

      {/* First-user notice */}
      {!checkingFirst && isFirst && (
        <div className="mb-4 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm text-blue-600 dark:text-blue-400">
          <strong>{t("First user:")}</strong>{" "}
          {t(
            "You will be granted admin privileges and can manage other users from the admin dashboard.",
          )}
        </div>
      )}

      {/* Card */}
      <div className="chrome-card border border-[var(--border)] bg-[var(--card)] px-8 py-8 shadow-[0_16px_40px_-18px_rgba(28,24,22,0.18)]">
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Email or username */}
          <div>
            <label
              htmlFor="username"
              className="block text-sm font-medium text-[var(--foreground)] mb-1.5"
            >
              {t("Email or username")}
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3.5 py-2.5
                         text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]
                         transition-shadow focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--ring)]/40"
              placeholder={t("you@example.com")}
            />
          </div>

          {/* Password */}
          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-[var(--foreground)] mb-1.5"
            >
              {t("Password")}
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3.5 py-2.5
                         text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]
                         transition-shadow focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--ring)]/40"
              placeholder="••••••••"
            />
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">
              {t("At least 8 characters")}
            </p>
          </div>

          {/* Confirm Password */}
          <div>
            <label
              htmlFor="confirmPassword"
              className="block text-sm font-medium text-[var(--foreground)] mb-1.5"
            >
              {t("Confirm password")}
            </label>
            <input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3.5 py-2.5
                         text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]
                         transition-shadow focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--ring)]/40"
              placeholder="••••••••"
            />
          </div>

          {/* Error message */}
          {error && (
            <p className="text-sm text-red-500 bg-red-500/10 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-[var(--primary)] px-4 py-2.5 text-sm font-medium
                       text-[var(--primary-foreground)] shadow-md shadow-[var(--primary)]/15
                       transition-all hover:opacity-90 active:scale-[0.99]
                       disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
          >
            {loading ? t("Creating account…") : t("Create account")}
          </button>
        </form>
      </div>

      <p className="mt-6 text-center text-sm text-[var(--muted-foreground)]">
        {t("Already have an account?")}{" "}
        <Link
          href="/login"
          className="text-[var(--primary)] hover:underline font-medium"
        >
          {t("Sign in")}
        </Link>
      </p>

      <p className="mt-3 text-center text-xs text-[var(--muted-foreground)]">
        {t("Knorvia · Agent-Native Learning")}
      </p>
    </div>
  );
}
