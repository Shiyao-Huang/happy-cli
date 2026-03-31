declare module 'js-yaml' {
    const yaml: {
        load(input: string): unknown
        dump(value: unknown): string
    }

    export default yaml
}
