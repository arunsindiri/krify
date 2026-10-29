import os

from dotenv import load_dotenv
from fastapi import FastAPI
from groq import Groq
from pydantic import BaseModel

load_dotenv()

app = FastAPI()

client = Groq(api_key=os.getenv("GROQ_API_KEY"))


class TaskRequest(BaseModel):
    instruction: str


@app.get("/")
def home():
    return {
        "message": "AI Browser Assistant Backend is running!"
    }


@app.post("/task")
def receive_task(data: TaskRequest):
    response = client.chat.completions.create(
        model="openai/gpt-oss-120b",
        messages=[
            {
                "role": "system",
                "content": """
You are an AI browser assistant.

Understand the user's instruction and decide what browser action is needed.

For now, you can only open websites.

Return ONLY a JSON object in this format:
{
    "action": "open_website",
    "url": "https://www.youtube.com",
    "message": "Opening YouTube"
}

Rules:
1. If the user asks to open a website, return its URL.
2. Use HTTPS URLs.
3. If the request is not about opening a website, return:
{
    "action": "unknown",
    "url": "",
    "message": "I cannot perform that task yet."
}
4. Return valid JSON only.
"""
            },
            {
                "role": "user",
                "content": data.instruction
            }
        ],
    )

    ai_response = response.choices[0].message.content

    import json

    try:
        result = json.loads(ai_response)
    except (json.JSONDecodeError, TypeError):
        return {
            "action": "unknown",
            "url": "",
            "message": "The AI returned an invalid response."
        }

    return result