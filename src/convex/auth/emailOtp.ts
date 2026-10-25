import { Email } from "@convex-dev/auth/providers/Email";
import { Resend } from "resend";
import { RandomReader, generateRandomString } from "@oslojs/crypto/random";

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
    const from = process.env.AUTH_EMAIL_FROM;
    if (!provider.apiKey || !from) {
      throw new Error("Email OTP requires AUTH_RESEND_KEY and AUTH_EMAIL_FROM on this Convex deployment.");
    }
    let result;
    try {
      const resend = new Resend(provider.apiKey);
      result = await resend.emails.send({
        from,
        to: [email],
        subject: "Your Focus Rewards sign-in code",
        text: `Your sign-in code is ${token}. It expires in 15 minutes. If you didn't request this code, you can ignore this email.`,
      });
    } catch {
      // Provider/network exceptions can include request metadata; do not expose them.
      throw new Error("Could not send the sign-in code. Check the Convex email provider configuration and try again.");
    }
    const { data, error } = result;
    if (error) {
      // Never return provider payloads: they may contain recipient or request data.
      throw new Error("Could not send the sign-in code. Check the Convex email provider configuration and try again.");
    }
    if (!data?.id) {
      throw new Error("The email provider did not confirm sending the sign-in code.");
    }
  },
});
