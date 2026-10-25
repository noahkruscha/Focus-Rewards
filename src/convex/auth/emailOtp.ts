import { Email } from "@convex-dev/auth/providers/Email";
import { Resend } from "resend";
import { RandomReader, generateRandomString } from "@oslojs/crypto/random";

function safeDiagnostic(value: unknown, sensitiveValues: string[]): string {
  if (typeof value !== "string") return "unknown";
  let message = value;
  for (const secret of sensitiveValues) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  message = message.replace(/https?:\/\/[^\s]+/gi, "[url]");
  message = message.replace(/(?:^|\s)(?:to|recipient|email)\s*[:=]\s*[^\s,;]+/gi, " [recipient]=[redacted]");
  return message
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|x-api-key|api-key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b\d{6}\b/g, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
}

function diagnosticField(error: unknown, key: "name" | "message" | "statusCode"): unknown {
  if (typeof error !== "object" || error === null || !(key in error)) return undefined;
  return (error as Record<string, unknown>)[key];
}

export const emailOtp = Email({
  id: "email-otp",
  apiKey: process.env.AUTH_RESEND_KEY,
  maxAge: 60 * 15, // 15 minutes
  // This function can be asynchronous
  async generateVerificationToken() {
    const random: RandomReader = {
      read(bytes: Uint8Array) {
        crypto.getRandomValues(bytes);
      },
    };
    const alphabet = "0123456789";
    return generateRandomString(random, alphabet, 6);
  },
  async sendVerificationRequest({ identifier: email, token, provider }) {
    // Resend requires the configured From address to belong to a verified domain.
    const from = process.env.AUTH_EMAIL_FROM;
    if (!provider.apiKey || !from) {
      console.error("[auth:emailOtp] Email sender configuration missing", {
        hasApiKey: Boolean(provider.apiKey),
        hasFrom: Boolean(from),
      });
      throw new Error("Could not send the sign-in code. Check the email configuration and try again.");
    }
    const sensitiveValues = [provider.apiKey, email, token];
    let result;
    try {
      const resend = new Resend(provider.apiKey);
      result = await resend.emails.send({
        from,
        to: [email],
        subject: "Your Focus Rewards sign-in code",
        text: `Your sign-in code is ${token}. It expires in 15 minutes. If you didn't request this code, you can ignore this email.`,
      });
    } catch (caught) {
      // Log only sanitized scalar diagnostics, never exception objects or request metadata.
      console.error("[auth:emailOtp] Resend request threw", {
        name: safeDiagnostic(diagnosticField(caught, "name"), sensitiveValues),
        message: safeDiagnostic(diagnosticField(caught, "message"), sensitiveValues),
      });
      throw new Error("Could not send the sign-in code. Check the email configuration and try again.");
    }
    const { data, error } = result;
    if (error) {
      // The SDK error is reduced to sanitized fields; the full response is never logged.
      console.error("[auth:emailOtp] Resend rejected OTP email", {
        name: safeDiagnostic(diagnosticField(error, "name"), sensitiveValues),
        statusCode: typeof diagnosticField(error, "statusCode") === "number" ? diagnosticField(error, "statusCode") : null,
        message: safeDiagnostic(diagnosticField(error, "message"), sensitiveValues),
      });
      throw new Error("Could not send the sign-in code. Check the email configuration and try again.");
    }
    if (!data?.id) {
      console.error("[auth:emailOtp] Resend returned no email ID", { name: "unknown", statusCode: null, message: "No provider error was returned." });
      throw new Error("Could not send the sign-in code. Check the email configuration and try again.");
    }
  },
});
