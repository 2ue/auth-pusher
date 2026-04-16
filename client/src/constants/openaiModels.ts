import type { SelectOption } from '@/components/SelectField';

export const OPENAI_MODEL_IDS = ['gpt-5.2', 'gpt-5.4'] as const;

export function buildOpenAiModelOptions(selected?: string): SelectOption[] {
  const options: SelectOption[] = OPENAI_MODEL_IDS.map((model) => ({
    value: model,
    label: model,
  }));

  const value = selected?.trim();
  if (value && !options.some((option) => option.value === value)) {
    options.unshift({ value, label: `${value} (自定义)` });
  }

  return options;
}
