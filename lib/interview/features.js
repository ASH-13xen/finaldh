// Server-side switches for parts of the interview section.

// The mock interview room (sessions, the board's voice) is off until INTERVIEW_MOCK_ENABLED=true: for now
// the section is DAF, predicted questions, the bank and practice. The code stays for when it comes back.
export const mockInterviewEnabled = () => process.env.INTERVIEW_MOCK_ENABLED === 'true';
