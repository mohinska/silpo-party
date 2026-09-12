export function parseFoodIntentInput(value: string) {
  const input = value.trim().slice(0, 1_200);
  const isUrl = /^https?:\/\/\S+$/i.test(input);
  return {
    dishName: isUrl ? "" : input.slice(0, 120),
    description: "",
    contentUrl: isUrl ? input.slice(0, 500) : "",
    indifferent: false,
  };
}
