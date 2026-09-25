import { NextResponse } from "next/server";
import { getUsdToCnyRate } from "@/lib/exchangeRate.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rate = await getUsdToCnyRate();
    return NextResponse.json(rate);
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch exchange rate" },
      { status: 503 },
    );
  }
}
