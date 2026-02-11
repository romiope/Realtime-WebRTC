import VoiceChat from "@/components/VoiceChat";

export default function Home() {
  return (
    <div className="flex flex-col min-h-screen bg-zinc-950">
      {/* Background gradient effects */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -right-40 w-96 h-96 bg-violet-600/5 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 bg-indigo-600/5 rounded-full blur-3xl" />
      </div>

      {/* Main content */}
      <div className="relative flex flex-col flex-1 max-h-screen">
        <VoiceChat />
      </div>
    </div>
  );
}
