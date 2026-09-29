import { collectRefNames, getOperationSuccessResponses, resolveDependencyOperationFile, resolveResponseTypes } from '@internals/shared'
import { ast, defineGenerator } from 'kubb/kit'
import { pluginFakerName } from '@kubb/plugin-faker'
import { pluginTsName } from '@kubb/plugin-ts'
import { File, jsxRenderer } from 'kubb/jsx'
import { Mock, Response } from '../components'
import type { PluginMsw } from '../types'
import { hasResponseSchema, resolveFakerMeta } from '../utils.ts'

/**
 * Built-in operation generator for `@kubb/plugin-msw`. Emits one MSW handler
 * per OpenAPI operation. With `parser: 'faker'` the handler returns a value
 * from `@kubb/plugin-faker`; with `parser: 'data'` it returns a typed empty
 * payload for tests to fill in.
 */
export const mswGenerator = defineGenerator<PluginMsw>({
  name: 'msw',
  renderer: jsxRenderer,
  operation(node, ctx) {
    if (!ast.isHttpOperationNode(node)) return null
    const { driver, resolver, config, root } = ctx
    const { output, parser, baseURL, group } = ctx.options

    const fileName = resolver.name(node.operationId)
    const mock = {
      name: resolver.handler.name(node),
      file: resolver.file({ name: fileName, extname: '.ts', tag: node.tags[0] ?? 'default', path: node.path, root, output, group: group ?? undefined }),
    }

    const fakerPlugin = parser === 'faker' ? driver.getPlugin(pluginFakerName) : null
    const fakerResolver = fakerPlugin ? driver.getResolver(pluginFakerName) : null
    const faker =
      fakerPlugin && fakerResolver
        ? resolveFakerMeta(node, {
            root,
            fakerResolver,
            fakerOutput: fakerPlugin.options?.output ?? output,
            fakerGroup: fakerPlugin.options?.group ?? null,
          })
        : null

    const pluginTs = driver.getPlugin(pluginTsName)
    if (!pluginTs) return null
    const tsResolver = driver.getResolver(pluginTsName)

    const type = {
      file: resolveDependencyOperationFile({
        cache: ctx.cache,
        node,
        resolver: tsResolver,
        root,
        output: pluginTs.options?.output ?? output,
        group: pluginTs.options?.group,
      }),
      responseName: tsResolver.response.response(node),
    }

    const successResponses = getOperationSuccessResponses(node)
    const referencedNames = node.responses.flatMap((response) =>
      (response.content ?? []).flatMap((entry) => (entry.schema ? collectRefNames(entry.schema) : [])),
    )
    const enumOptions = pluginTs.options?.enum
    const enumNames = new Set(ctx.meta.enumNames)
    const hasResponseNameCollision = referencedNames.some((name) => {
      const importName =
        enumOptions?.type === 'asConst' && enumOptions.typeSuffix && enumNames.has(name)
          ? tsResolver.enum.keyName({ name }, enumOptions.typeSuffix)
          : tsResolver.name(name)
      return importName === type.responseName
    })
    const hasFakerNameCollision = faker && fakerResolver && referencedNames.some((name) => fakerResolver.name(name) === faker.name)
    const types = resolveResponseTypes(node, tsResolver).map(([code, typeName]) => {
      const response = node.responses.find((item) => item.statusCode === String(code))
      if (response && !response.content?.some((entry) => entry.schema)) return [code, 'void'] as const

      const successResponse = successResponses.find((response) => response.statusCode === String(code))
      return [code, hasResponseNameCollision && successResponse ? tsResolver.response.status(node, successResponse.statusCode) : typeName] as const
    })
    const mockResponseName =
      hasResponseNameCollision && successResponses[0] ? tsResolver.response.status(node, successResponses[0].statusCode) : type.responseName
    const fakerResponseName = hasFakerNameCollision && successResponses[0] ? fakerResolver.response.status(node, successResponses[0].statusCode) : faker?.name
    const hasPrimarySuccessSchema = hasResponseSchema(successResponses[0])
    const hasResponseSchemaType = node.responses.some((response) => response.content?.some((entry) => entry.schema))

    const requestName = node.requestBody?.content?.[0]?.schema ? tsResolver.response.body(node) : null

    return (
      <File
        baseName={mock.file.baseName}
        path={mock.file.path}
        meta={mock.file.meta}
        banner={resolver.default.banner(ctx.meta, { output, config, file: { path: mock.file.path, baseName: mock.file.baseName } })}
        footer={resolver.default.footer(ctx.meta, { output, config, file: { path: mock.file.path, baseName: mock.file.baseName } })}
      >
        <File.Import name={['http']} path="msw" />
        <File.Import name={['HttpResponseResolver']} isTypeOnly path="msw" />
        <File.Import
          name={Array.from(
            new Set([
              ...(!hasResponseNameCollision && hasResponseSchemaType ? [type.responseName] : []),
              ...types.filter(([code, typeName]) => code !== 'default' && typeName !== 'void').map((t) => t[1]),
              ...(requestName ? [requestName] : []),
            ]),
          )}
          path={type.file.path}
          root={mock.file.path}
          isTypeOnly
        />
        {parser === 'faker' && faker && hasPrimarySuccessSchema && (
          <File.Import name={[fakerResponseName ?? faker.name]} root={mock.file.path} path={faker.file.path} />
        )}

        {types
          .filter(([code]) => code !== 'default')
          .map(([code, typeName]) => {
            const response = node.responses.find((item) => item.statusCode === String(code))
            if (!response) return null
            return <Response key={typeName} typeName={typeName} response={response} name={mock.name} />
          })}

        {parser === 'faker' && faker && hasPrimarySuccessSchema ? (
          <Mock
            name={mock.name}
            typeName={mockResponseName}
            requestTypeName={requestName}
            fakerName={fakerResponseName ?? faker.name}
            node={node}
            baseURL={baseURL}
          />
        ) : (
          <Mock name={mock.name} typeName={mockResponseName} requestTypeName={requestName} node={node} baseURL={baseURL} />
        )}
      </File>
    )
  },
})
