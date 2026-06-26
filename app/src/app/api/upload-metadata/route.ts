import { NextRequest, NextResponse } from "next/server";
import { hashDescription } from "@nebgov/sdk";

/**
 * API route for secure IPFS metadata upload.
 * 
 * This route handles Pinata uploads server-side to avoid exposing the Pinata JWT
 * to client-side JavaScript (preventing XSS attacks from accessing the JWT).
 * 
 * POST /api/upload-metadata
 * Body: { description: string, pinataJwt?: string }
 * 
 * Returns: { uri: string, hash: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { description, pinataJwt } = body;

    if (!description || typeof description !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid description" },
        { status: 400 }
      );
    }

    // Hash the description using the SDK function
    const hash = await hashDescription(description);

    // Determine which Pinata JWT to use
    const jwt = pinataJwt || process.env.NEXT_PRIVATE_PINATA_JWT;

    if (!jwt) {
      return NextResponse.json(
        { error: "No Pinata JWT configured. Please provide pinataJwt in request or set NEXT_PRIVATE_PINATA_JWT env var." },
        { status: 400 }
      );
    }

    // Prepare the request to Pinata
    const pinataBody = {
      pinataContent: {
        description,
        version: "1.0",
      },
      pinataMetadata: {
        name: `nebgov-proposal-${hash.substring(0, 8)}`,
      },
    };

    const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(pinataBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Pinata upload failed: ${response.status} ${errorText}`);
      return NextResponse.json(
        { error: `Pinata upload failed: ${response.status}` },
        { status: response.status }
      );
    }

    const data = (await response.json()) as { IpfsHash: string };
    const uri = `ipfs://${data.IpfsHash}`;

    return NextResponse.json({ uri, hash });
  } catch (error) {
    console.error("Upload metadata error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 }
    );
  }
}
