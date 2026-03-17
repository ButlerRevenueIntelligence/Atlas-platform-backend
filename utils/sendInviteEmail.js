import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendInviteEmail({ to, workspaceName, role, inviteToken }) {
  const appUrl = process.env.APP_FRONTEND_URL || "https://app.atlasrevenueai.com";
  const inviteLink = `${appUrl}/accept-invite?token=${inviteToken}`;

  console.log("📨 Sending invite email to:", to);
  console.log("📨 Using SMTP user:", process.env.SMTP_USER);

  const info = await transporter.sendMail({
    from: process.env.INVITE_FROM || process.env.SMTP_USER,
    to,
    subject: `You’ve been invited to join ${workspaceName} on Atlas Revenue AI`,
    text: `You were invited to join ${workspaceName} as ${role}. Accept here: ${inviteLink}`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6;">
        <h2>You’ve been invited to Atlas Revenue AI</h2>
        <p>You were invited to join <strong>${workspaceName}</strong> as <strong>${role}</strong>.</p>
        <p><a href="${inviteLink}">Accept Invite</a></p>
        <p>${inviteLink}</p>
      </div>
    `,
  });

  console.log("✅ Invite email sent:", info.messageId);
  return info;
}